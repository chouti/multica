"use client";

import { useState, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppLink, resolveClickIntent, useNavigation } from "../navigation";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  CalendarClock,
  CalendarDays,
  Check,
  ChevronRight,
  CircleUser,
  FolderKanban,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Settings2,
  Shapes,
  Tag,
  X as XIcon,
} from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import { toast } from "sonner";
import type {
  Issue,
  IssueStatus,
  IssuePriority,
  IssueAssigneeType,
  IssuePropertyValue,
} from "@multica/core/types";
import { contentReferencesAttachment } from "@multica/core/types";
import {
  DialogContent,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@multica/ui/components/ui/tooltip";
import { Button } from "@multica/ui/components/ui/button";
import { Switch } from "@multica/ui/components/ui/switch";
import { ContentEditor, type ContentEditorRef, TitleEditor, type TitleEditorRef, useFileDropZone, FileDropOverlay, useUploadGate, useComposerSubmit } from "../editor";
import { useIssueCreateUploads } from "./use-issue-create-uploads";
import { useShortcut } from "@multica/core/shortcuts";
import { ShortcutKeycaps } from "../common/shortcut-keycaps";
import { StatusIcon, StatusPicker, PriorityIcon, PriorityPicker, StagePicker, AssigneePicker, StartDatePicker, DueDatePicker, LabelPicker } from "../issues/components";
import { maxSiblingStage } from "../issues/components/pickers/stage-picker";
import { ProjectPicker } from "../projects/components/project-picker";
import { CreateRunHint, type SkillDesignationHint } from "../issues/components/create-run-hint";
import { useActorName } from "@multica/core/workspace/hooks";
import { useCurrentWorkspace, useWorkspacePaths } from "@multica/core/paths";
import { useWorkspaceId } from "@multica/core/hooks";
import { useIssueDraftStore, type IssueCreateDraft } from "@multica/core/issues/stores/draft-store";
import { useCreateModeStore } from "@multica/core/issues/stores/create-mode-store";
import { useQuickCreateStore } from "@multica/core/issues/stores/quick-create-store";
import { stripSkillMentionMarkdown } from "../issues/utils/strip-mention-markdown";
import { useSkillAutoBind } from "../issues/hooks/use-skill-auto-bind";
import { mentionLabelsByTarget, parseIssueSkillDesignationOutcomes, parseMentions } from "@multica/core/issues/comment-trigger-outcomes";
import { surfaceDesignationOutcomes } from "../issues/utils/skill-designation-toasts";
import {
  useIssueCreateSettingsStore,
  type ManualCreateField,
} from "@multica/core/issues/stores/issue-create-settings-store";
import { issueDetailOptions, childIssuesOptions } from "@multica/core/issues/queries";
import { useCreateIssue, useUpdateIssue } from "@multica/core/issues/mutations";
import { useAttachLabelToIssue } from "@multica/core/labels";
import {
  propertyListOptions,
  useSetIssueProperty,
} from "@multica/core/properties";
import {
  ApiError,
  DuplicateIssueErrorBodySchema,
  type DuplicateIssueErrorBody,
  parseWithFallback,
} from "@multica/core/api";
import { FileUploadButton } from "@multica/ui/components/common/file-upload-button";
import { ClearablePillButton, PillButton } from "../common/pill-button";
import { PropertyIcon } from "../common/property-icon";
import {
  CustomPropertyValueDisplay,
  CustomPropertyValueInput,
} from "../issues/components/pickers/custom-property-picker";
import { IssuePickerModal } from "./issue-picker-modal";
import { useT } from "../i18n";

// ---------------------------------------------------------------------------
// ManualCreatePanel — manual-mode body of the create-issue dialog. Renders
// DialogContent + everything inside; the surrounding `<Dialog>` is owned by
// CreateIssueDialog so mode switching swaps only the inner panel without
// remounting the Dialog Root (no overlay flash). `onSwitchMode` flips the
// shell's local mode state.
// ---------------------------------------------------------------------------

export function ManualCreatePanel({
  onClose,
  onSwitchMode,
  data,
  isExpanded,
  setIsExpanded,
}: {
  onClose: () => void;
  /** Called with the carry payload to seed the agent panel after switch. */
  onSwitchMode?: (carry?: Record<string, unknown> | null) => void;
  data?: Record<string, unknown> | null;
  /** Lifted to the shell so DialogContent's mode-aware className can react
   *  without the body itself having to live inside DialogContent (which would
   *  re-mount the Portal on mode swap and replay the open animation). */
  isExpanded: boolean;
  setIsExpanded: (v: boolean) => void;
}) {
  const { t } = useT("modals");
  const { t: tIssues } = useT("issues");
  const { t: tEditor } = useT("editor");
  const { t: tProjects } = useT("projects");
  const router = useNavigation();
  const p = useWorkspacePaths();
  const workspaceName = useCurrentWorkspace()?.name;
  const { getActorName } = useActorName();

  const draft = useIssueDraftStore((s) => s.draft);
  const setManual = useIssueDraftStore((s) => s.setManual);
  const setShared = useIssueDraftStore((s) => s.setShared);
  const setAgent = useIssueDraftStore((s) => s.setAgent);
  const setActiveMode = useIssueDraftStore((s) => s.setActiveMode);
  const clearDraft = useIssueDraftStore((s) => s.clearDraft);
  const setLastAssignee = useIssueDraftStore((s) => s.setLastAssignee);
  const setLastMode = useCreateModeStore((s) => s.setLastMode);
  const keepOpen = useQuickCreateStore((s) => s.keepOpen);
  const setKeepOpen = useQuickCreateStore((s) => s.setKeepOpen);
  const manualFields = useIssueCreateSettingsStore((s) => s.manualCreateFields);

  const sendShortcut = useShortcut("send");
  const [title, setTitle] = useState(draft.manual.title);
  const [formResetKey, setFormResetKey] = useState(0);
  const titleEditorRef = useRef<TitleEditorRef>(null);
  const descEditorRef = useRef<ContentEditorRef>(null);
  // Skill-mention designation context (U4): the description editor's @skill
  // chips get the same composer-owned designation state as the comment
  // composers — the manual chip-click picker works here, and typed skill
  // insertions register in the composer's single popover slot via the
  // existing useSkillMentionAutoOpen gate. The recommendation / auto-fill
  // engine (U5) wires on top via useSkillAutoBind below, which internally
  // owns its own auto-open gate and reads the live description + form
  // assignee to compute the recommendation.
  const [skillMentionAgents, setSkillMentionAgents] = useState<Record<string, string[]>>({});
  const [openPopoverFor, setOpenPopoverFor] = useState<string | null>(null);
  const { isDragOver: descDragOver, dropZoneProps: descDropZoneProps } = useFileDropZone({
    onDrop: (files) => files.forEach((f) => descEditorRef.current?.uploadFile(f)),
  });
  const [status, setStatus] = useState<IssueStatus>((data?.status as IssueStatus) || draft.manual.status);
  const [priority, setPriority] = useState<IssuePriority>(
    (data?.priority as IssuePriority | undefined) ?? draft.shared.priority,
  );
  const [assigneeType, setAssigneeType] = useState<IssueAssigneeType | undefined>(() => {
    if (data && "assignee_type" in data) {
      return (data.assignee_type as IssueAssigneeType | null) ?? undefined;
    }
    return draft.manual.assigneeType;
  });
  const [assigneeId, setAssigneeId] = useState<string | undefined>(() => {
    if (data && "assignee_id" in data) {
      return (data.assignee_id as string | null) ?? undefined;
    }
    return draft.manual.assigneeId;
  });
  const [startDate, setStartDate] = useState<string | null>(draft.manual.startDate);
  const [dueDate, setDueDate] = useState<string | null>(
    (data?.due_date as string | undefined) ?? draft.shared.dueDate,
  );
  const [labelIds, setLabelIds] = useState<string[]>(draft.manual.labelIds);
  const [propertyValues, setPropertyValues] = useState(draft.manual.propertyValues ?? {});
  const [customPropertyPickerId, setCustomPropertyPickerId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | undefined>(() => {
    if (data && "project_id" in data) {
      return (data.project_id as string | null) ?? undefined;
    }
    return draft.shared.projectId;
  });
  const [parentIssueId, setParentIssueId] = useState<string | undefined>(
    (data?.parent_issue_id as string) || undefined,
  );
  // Stage only applies to a sub-issue; kept local (not in the persisted draft)
  // since it's a per-creation choice tied to the chosen parent.
  const [stage, setStage] = useState<number | null>(
    typeof data?.stage === "number" ? (data.stage as number) : null,
  );
  const [parentPickerOpen, setParentPickerOpen] = useState(false);
  // Toolbar fields hidden via Settings → Issue reuse the overflow reveal
  // pattern: the ⋯ menu item flips this open, which mounts the inline pill
  // (the popover's anchor) AND opens the picker. Closing without a value
  // unmounts the pill again; a field holding a non-default value always
  // renders regardless of the setting so nothing applied is ever invisible.
  const [fieldPickerOpen, setFieldPickerOpen] = useState<Exclude<
    ManualCreateField,
    "due_date" | "start_date"
  > | null>(null);
  // Start date is a low-frequency field — by default it lives in the
  // overflow ⋯ menu. Clicking the menu item flips this open, which both
  // mounts the inline pill (the popover's anchor) AND opens the calendar.
  // When the popover closes without a value set, the pill unmounts again.
  const [startDatePickerOpen, setStartDatePickerOpen] = useState(false);
  // Due date follows the same overflow pattern as start date: collapsed into
  // the ⋯ menu by default, mounted inline (as the popover anchor) only when it
  // has a value or the user just opened it from the menu.
  const [dueDatePickerOpen, setDueDatePickerOpen] = useState(false);
  // Children live as full Issue objects — the picker always returns the whole
  // object, and we never need to hydrate from an ID the way we do for parent.
  const [childIssues, setChildIssues] = useState<Issue[]>([]);
  const [childPickerOpen, setChildPickerOpen] = useState(false);
  // Fetch parent issue details for the chip (status/identifier/title).
  // List cache usually has it already, so this resolves synchronously.
  const wsId = useWorkspaceId();
  const { data: workspaceProperties = [] } = useQuery(propertyListOptions(wsId));
  const { data: parentIssue } = useQuery({
    ...issueDetailOptions(wsId, parentIssueId ?? ""),
    enabled: !!parentIssueId,
  });
  // Sibling stages under the chosen parent, so the Stage picker can offer the
  // already-used max stage (and one beyond) instead of flooring at Stage 1–3.
  const { data: parentChildren = [] } = useQuery({
    ...childIssuesOptions(wsId, parentIssueId ?? ""),
    enabled: !!parentIssueId,
  });

  // Skill-mention auto-open + recommendation / auto-fill engine (U5): the
  // recommendation engine reads `description` (description mentions → tier 0)
  // and `formAssignee` (the assignee source for the create path — no issueId
  // exists yet). Touched / sticky / paste-exclusion / reverse-timing fill
  // all live inside the engine. The single popover slot, the session
  // freshness scan, and the typed-insert auto-open gate (KTD3 in-flight
  // drop, KTD4 agent-list gate) are all owned by this hook.
  //
  // `descriptionMirror` is a local mirror of the editor's current markdown,
  // updated via the editor's `onUpdate`. The persistent source of truth is
  // the draft store (where U6 will persist it across modal reopens), but
  // the draft-store selector doesn't drive a React re-render on every
  // keystroke in the test harness — the local mirror closes that gap so the
  // recommendation engine sees freshly-typed mentions on its next render.
  const [descriptionMirror, setDescriptionMirror] = useState<string>(
    () => draft.manual.description || "",
  );
  // The create-issue modal has no trigger-chip strip, so suppression is
  // always empty. Stable reference so the engine's effect deps stay quiet.
  const emptySuppressedRef = useRef<ReadonlySet<string>>(new Set());
  const autoBind = useSkillAutoBind({
    wsId,
    description: descriptionMirror,
    formAssignee: assigneeType ? { type: assigneeType, id: assigneeId } : undefined,
    suppressedAgentIds: emptySuppressedRef.current,
    skillMentionAgents,
    setSkillMentionAgents,
    editorRef: descEditorRef,
    setOpenPopoverFor,
    initialTouchedSkillIds: draft.manual.skillMentionTouched,
    initialFilledSkillIds: draft.manual.skillMentionFilled,
  });
  const {
    handleSkillMentionInserted,
    handleSkillMentionChange,
    syncSkillMentionsWithDoc,
  } = autoBind;

  // U7 — derive the per-chip designation lines for the run hint. The chip
  // label is recovered from the description markdown (the user typed it there,
  // so we never have to round-trip a skills query just to render the line);
  // the agent name comes from `useActorName`. Backlog suppresses the run —
  // bind-only path (R8) — so `willRun: false` for that branch. Renders
  // nothing when the map is empty (R12 silent no-op contract).
  const designationHints = useMemo<SkillDesignationHint[]>(() => {
    const entries = Object.entries(skillMentionAgents);
    if (entries.length === 0) return [];
    const labelMap = mentionLabelsByTarget(descriptionMirror);
    const willRun = status !== "backlog";
    const out: SkillDesignationHint[] = [];
    for (const [skillId, agentIds] of entries) {
      // Mirror `useSkillDesignationSubmit`: an explicit empty list is a
      // silent no-op (R12); skip so the run hint doesn't surface a line
      // for a chip the user has already cleared.
      if (!agentIds || agentIds.length === 0) continue;
      const skillLabel = labelMap.get(`skill:${skillId}`) ?? skillId;
      for (const agentId of agentIds) {
        out.push({
          skillLabel,
          agentName: getActorName("agent", agentId),
          willRun,
        });
      }
    }
    return out;
  }, [skillMentionAgents, descriptionMirror, status, getActorName]);

  // R14 — chips in the document with no agent picked (unresolved
  // designation). Computed from the same parseMentions source the
  // designation hints use; the unresolved surface lists every `skill`
  // mention whose id isn't present in `skillMentionAgents` (or is present
  // with an empty agent list — user explicitly cleared the designation).
  // Paste / undo / draft-restore chips are intentionally included: R14's
  // pre-submit reveal band is the "no candidate" fallback, distinct from
  // the R5 auto-popover exclusion.
  const unresolvedSkillLabels = useMemo<readonly string[]>(() => {
    const out: string[] = [];
    for (const mention of parseMentions(descriptionMirror)) {
      if (mention.type !== "skill") continue;
      const agentIds = skillMentionAgents[mention.id];
      if (agentIds && agentIds.length > 0) continue;
      out.push(mention.label);
    }
    return out;
  }, [descriptionMirror, skillMentionAgents]);

  // Set the persisted draft's active mode so a later reopen (and any reader of
  // the unified draft) knows which form the user is editing in.
  useEffect(() => {
    setActiveMode("manual");
  }, [setActiveMode]);

  // Prune completed uploads whose markdown reference was deleted in an
  // earlier editing session. Runs once on mount: at that point the persisted
  // manual description / agent prompt ARE the draft bodies (no editor edits
  // have happened yet), so dropping `uploaded` records referenced by neither
  // is safe. Placeholders (uploading / failed / interrupted) are always kept —
  // they have no body reference yet and the status chips are their only UI.
  // Don't prune on description updates — an onUpdate flush can race a
  // just-finished upload whose markdown link hasn't been inserted yet, and
  // pruning there would drop a live attachment.
  useEffect(() => {
    const { draft: current } = useIssueDraftStore.getState();
    const uploads = current.shared.attachments ?? [];
    const kept = uploads.filter(
      (u) =>
        u.status !== "uploaded" ||
        contentReferencesAttachment(current.manual.description, u.attachment) ||
        contentReferencesAttachment(current.agent.prompt, u.attachment),
    );
    if (kept.length !== uploads.length) setShared({ attachments: kept });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Gate every action that fixes this draft: Create and the switch to agent
  // mode (which assist-inits the agent prompt from the description and would
  // carry a stripped body across).
  const uploadGate = useUploadGate(descEditorRef);
  // Coordinator-owned uploads in the shared pool (MUL-5181, L2): a file picked
  // here survives dialog close, aborts on logout, and is dropped after a
  // reload. `gate` widens the editor gate with the pool's placeholders.
  const {
    attachments: draftAttachments,
    handleUpload,
    gate,
  } = useIssueCreateUploads("manual", uploadGate, descEditorRef);

  // Sync field changes to the draft store — manual-only fields to the manual
  // slot, project / priority / due date to the shared slot.
  const updateTitle = (v: string) => { setTitle(v); setManual({ title: v }); };
  const updateStatus = (v: IssueStatus) => { setStatus(v); setManual({ status: v }); };
  const updatePriority = (v: IssuePriority) => { setPriority(v); setShared({ priority: v }); };
  const updateAssignee = (type?: IssueAssigneeType, id?: string) => {
    setAssigneeType(type); setAssigneeId(id);
    setManual({ assigneeType: type, assigneeId: id });
  };
  const updateProject = (id?: string) => { setProjectId(id); setShared({ projectId: id }); };
  const updateStartDate = (v: string | null) => { setStartDate(v); setManual({ startDate: v }); };
  const updateDueDate = (v: string | null) => { setDueDate(v); setShared({ dueDate: v }); };
  const updateLabelIds = (ids: string[]) => { setLabelIds(ids); setManual({ labelIds: ids }); };
  const updatePropertyValue = (propertyId: string, value: IssuePropertyValue | undefined) => {
    const next = { ...propertyValues };
    if (value === undefined) delete next[propertyId];
    else next[propertyId] = value;
    setPropertyValues(next);
    setManual({ propertyValues: next });
  };

  // Inline pill reveal per toolbar field: kept by Settings → Issue, holding a
  // non-default value (a hidden field with a value must stay visible — the
  // draft or a mode-switch carry may have set it), or just opened from the ⋯
  // overflow (the picker popover needs the inline pill as its anchor).
  const showField = {
    status: manualFields.includes("status") || status !== "todo" || fieldPickerOpen === "status",
    priority: manualFields.includes("priority") || priority !== "none" || fieldPickerOpen === "priority",
    assignee: manualFields.includes("assignee") || assigneeId != null || fieldPickerOpen === "assignee",
    labels: manualFields.includes("labels") || labelIds.length > 0 || fieldPickerOpen === "labels",
    project: manualFields.includes("project") || projectId != null || fieldPickerOpen === "project",
    due_date: manualFields.includes("due_date") || dueDate !== null || dueDatePickerOpen,
    start_date: manualFields.includes("start_date") || startDate !== null || startDatePickerOpen,
  };

  const createIssueMutation = useCreateIssue();
  const updateIssueMutation = useUpdateIssue();
  const attachLabelMutation = useAttachLabelToIssue();
  const setIssuePropertyMutation = useSetIssueProperty();
  const resetForNextIssue = () => {
    setTitle("");
    setStatus("todo");
    setPriority("none");
    setStartDate(null);
    setDueDate(null);
    setLabelIds([]);
    setPropertyValues({});
    setCustomPropertyPickerId(null);
    setProjectId(undefined);
    setParentIssueId(undefined);
    setStage(null);
    setChildIssues([]);
    // Drop the description editor's per-issue designation state so the next
    // issue starts on a clean slate; the editor's clearContent below wipes
    // the chips too, but the map would linger without this.
    setSkillMentionAgents({});
    setOpenPopoverFor(null);
    // Keep the just-used assignee for the next issue in the batch; reset
    // everything else across the manual + shared slots.
    setManual({
      title: "",
      description: "",
      status: "todo",
      assigneeType,
      assigneeId,
      startDate: null,
      labelIds: [],
      propertyValues: {},
    });
    setShared({
      priority: "none",
      projectId: undefined,
      dueDate: null,
      attachments: [],
    });
    descEditorRef.current?.clearContent();
    setFormResetKey((key) => key + 1);
  };

  // Manual create runs through the shared await-then-render composer contract
  // (single-flight ref, submit-time upload re-check, lock+spin, await→boolean,
  // clear only on acceptance). Manual is gated on the TITLE rather than the
  // editor body — a title-only issue is valid — so `normalize` ignores the
  // description markdown and feeds the title through as the empty-guard/content;
  // the body is read separately inside onSubmit.
  // Stale-submit guard (MUL-5181 P0): the issue draft is a SINGLETON store
  // and the editors stay interactive during a request. Snapshot the draft's
  // object identity at submit; success clears ONLY an untouched draft —
  // whether the edit came mid-flight or from a reopened dialog.
  const mountedRef = useRef(true);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const submittedDraftRef = useRef<IssueCreateDraft | null>(null);

  const composer = useComposerSubmit({
    editorRef: descEditorRef,
    uploadGate: gate,
    normalize: () => title.trim(),
    onSubmit: async (): Promise<boolean> => {
      // Flush the description editor's pending debounce into the store BEFORE
      // snapshotting, so a late flush of pre-submit typing cannot masquerade
      // as an edit made during the request.
      const pendingDesc = descEditorRef.current?.flushPendingUpdate?.();
      if (pendingDesc != null) setManual({ description: pendingDesc });
      submittedDraftRef.current = useIssueDraftStore.getState().draft;
      try {
      const description = descEditorRef.current?.getMarkdown()?.trim() || undefined;
      const activeAttachmentIds = draftAttachments
        .filter((a) => contentReferencesAttachment(description ?? "", a))
        .map((a) => a.id);
      // U6: terminal fill — read the live recommendation state for chips
      // the auto-bind engine resolved but whose fill effect hasn't
      // committed yet (cold-start race, KTD5). Empty map → omit the field
      // (server treats omitted as "no designation", R12).
      const skillMentionAgentsPayload = autoBind.finalizeSkillMentionAgents();
      const issue = await createIssueMutation.mutateAsync({
        title: title.trim(),
        description,
        status,
        priority,
        assignee_type: assigneeType,
        assignee_id: assigneeId,
        start_date: startDate || undefined,
        due_date: dueDate || undefined,
        attachment_ids: activeAttachmentIds.length > 0 ? activeAttachmentIds : undefined,
        // The server attaches these in the same transaction as the create and
        // echoes them back as `issue.labels`, so a stale selection fails the
        // create instead of leaving a committed-but-unlabeled issue. A legacy
        // backend that predates this ignores the field — handled by the
        // compatibility fallback below.
        label_ids: labelIds.length > 0 ? labelIds : undefined,
        // @skill designation map. Sent alongside the create payload so the
        // server binds the agents in the same transaction (R6 / U2). Empty
        // map is omitted — sending `{}` would explicitly clear every
        // designation, which the user did not ask for here (R12).
        skill_mention_agents: skillMentionAgentsPayload,
        parent_issue_id: parentIssueId,
        // Stage is only meaningful for a sub-issue (relative to its siblings).
        stage: parentIssueId && stage != null ? stage : undefined,
        project_id: projectId,
      });

      // Custom-property values can only be addressed once the issue has an
      // id. Keep the modal in its submitting state until every value settles
      // so closing or "Create another" cannot race the fan-out.
      const propertyEntries = Object.entries(propertyValues);
      if (propertyEntries.length > 0) {
        const results = await Promise.allSettled(
          propertyEntries.map(([propertyId, value]) =>
            setIssuePropertyMutation.mutateAsync({
              issueId: issue.id,
              propertyId,
              value,
            }),
          ),
        );
        let failed = 0;
        for (const result of results) {
          if (result.status === "rejected") {
            failed += 1;
            console.error("[create-issue] custom property set failed", result.reason);
          }
        }
        if (failed > 0) {
          toast.error(
            t(($) => $.create_issue.toast_set_properties_failed, { count: failed }),
          );
        }
      }

      // Link queued children to the new parent. Deferred to after create
      // because the new issue's ID doesn't exist yet. Partial failures don't
      // roll back the new issue — it's already committed.
      if (childIssues.length > 0) {
        const results = await Promise.allSettled(
          childIssues.map((child) =>
            updateIssueMutation.mutateAsync({
              id: child.id,
              parent_issue_id: issue.id,
            }),
          ),
        );
        // Aggregate fan-out: N independent requests can fail for N different
        // reasons. The user-facing toast stays count-based (any single
        // err.message would mislead), but log each rejection so developers
        // still have signal in dev-tools / Sentry.
        for (const result of results) {
          if (result.status === "rejected") {
            console.error("[create-issue] sub-issue link failed", result.reason);
          }
        }
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed > 0) {
          toast.error(
            failed === childIssues.length
              ? t(($) => $.create_issue.toast_link_subissues_all_failed)
              : t(($) => $.create_issue.toast_link_subissues_partial, {
                  failed,
                  total: childIssues.length,
                }),
          );
        }
      }

      // Backend-compatibility fallback for the rolling deploy window: the web
      // app auto-deploys on merge but the backend deploys manually, so a newer
      // web build can briefly talk to a backend that predates atomic label
      // creation. That backend silently ignores `label_ids` and returns an
      // issue with no `labels` field. Only then do we fall back to the legacy
      // per-label attach so the user's labels aren't silently dropped. When
      // `labels` is present (current backend) the atomic path already ran, so
      // we skip this — no double-write, no per-label fan-out.
      if (labelIds.length > 0 && issue.labels === undefined) {
        const results = await Promise.allSettled(
          labelIds.map((labelId) =>
            attachLabelMutation.mutateAsync({ issueId: issue.id, labelId }),
          ),
        );
        let labelsFailed = 0;
        for (const result of results) {
          if (result.status === "rejected") {
            labelsFailed += 1;
            console.error("[create-issue] label attach fallback failed", result.reason);
          }
        }
        if (labelsFailed > 0) {
          toast.error(t(($) => $.create_issue.toast_link_labels_failed));
        }
      }

      // The old post-create "agent paused in Backlog" blocking panel is gone —
      // a passive inline hint now warns before submit (MUL-3375). The draft
      // reset + close/keep-open happens in onAccepted once we report success.
      {
        toast.custom((toastId) => (
          <div className="bg-popover text-popover-foreground border rounded-lg shadow-lg p-4 w-[360px]">
            <div className="flex items-center gap-2 mb-2">
              <div className="flex items-center justify-center size-5 rounded-full bg-emerald-500/15 text-emerald-500">
                <Check className="size-3" />
              </div>
              <span className="text-body font-medium">{t(($) => $.create_issue.toast_created)}</span>
            </div>
            <div className="flex items-center gap-2 text-body text-muted-foreground ml-7">
              <StatusIcon status={issue.status} className="size-3.5 shrink-0" />
              <span className="truncate">{issue.identifier} – {issue.title}</span>
            </div>
            {/* Not an AppLink: sonner renders toast content under <Toaster />,
                which is mounted outside NavigationProvider, so useNavigation()
                would throw here. */}
            <button
              type="button"
              className="ml-7 mt-2 text-body text-primary hover:underline cursor-pointer"
              onClick={() => {
                router.push(p.issueDetail(issue.id));
                toast.dismiss(toastId);
              }}
            >
              {t(($) => $.create_issue.view_issue)}
            </button>
          </div>
        ), { duration: 5000 });
      }
      // U7 — surface the post-create designation outcomes (R13 / R16). The
      // helper handles both the per-agent bind-only toast (R13) and the
      // aggregated blocked warning (R16) in one place so the create + edit
      // paths stay in sync. A missing or malformed outcomes field is a no-op
      // — the success toast above already covers the happy path.
      const createOutcomes = parseIssueSkillDesignationOutcomes(
        issue.skill_designation_outcomes,
      );
      surfaceDesignationOutcomes({
        outcomes: createOutcomes,
        getActorName,
        tModals: t,
        tIssues: tIssues,
      });
      return true;
    } catch (err) {
      // Duplicate-issue is the only structured 409 the create endpoint
      // returns. We schema-guard the body (ApiError.body is `unknown`) so a
      // future server-side rename / drop of `code` / `issue` degrades to the
      // normal error toast instead of throwing inside the toast renderer.
      if (err instanceof ApiError && err.status === 409) {
        const dup = parseWithFallback<DuplicateIssueErrorBody | null>(
          err.body,
          DuplicateIssueErrorBodySchema,
          null,
          { endpoint: "POST /api/workspaces/:wsId/issues (active_duplicate_issue)" },
        );
        if (dup) {
          toast.custom(
            (toastId) => (
              <div className="bg-popover text-popover-foreground border rounded-lg shadow-lg p-4 w-[360px]">
                <div className="flex items-center gap-2 mb-2">
                  <div className="flex items-center justify-center size-5 rounded-full bg-amber-500/15 text-amber-500">
                    <AlertTriangle className="size-3" />
                  </div>
                  <span className="text-body font-medium">
                    {t(($) => $.create_issue.toast_duplicate_title)}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-body text-muted-foreground ml-7">
                  <span className="truncate">{dup.issue.identifier} – {dup.issue.title}</span>
                </div>
                {/* See the created-issue toast above: toast content lives
                    outside NavigationProvider, so this stays a button. */}
                <button
                  type="button"
                  className="ml-7 mt-2 text-body text-primary hover:underline cursor-pointer"
                  onClick={() => {
                    router.push(p.issueDetail(dup.issue.id));
                    toast.dismiss(toastId);
                  }}
                >
                  {t(($) => $.create_issue.toast_duplicate_view)}
                </button>
              </div>
            ),
            { duration: 5000 },
          );
          return false;
        }
      }
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.create_issue.toast_failed),
      );
      return false;
    }
  },
    onAccepted: () => {
      // These preferences derive from the SUBMITTED values, not the live
      // draft — an issue was created, so record them regardless of the guard.
      setLastAssignee(assigneeType, assigneeId);
      setLastMode("manual");
      // Success may only consume the draft it submitted (MUL-5181 P0): any
      // edit after the submit snapshot — typing while the request is in
      // flight, or a reopened dialog — survives, and the dialog then stays
      // open on the newer draft instead of closing/resetting over it. Flush
      // the editor's pending debounce first so mid-flight typing still inside
      // the debounce window is judged correctly.
      const lateDesc = descEditorRef.current?.flushPendingUpdate?.();
      if (lateDesc != null) setManual({ description: lateDesc });
      const untouched =
        useIssueDraftStore.getState().draft === submittedDraftRef.current;
      if (untouched) clearDraft();
      if (!mountedRef.current || !untouched) return;
      if (keepOpen) {
        resetForNextIssue();
      } else {
        onClose();
      }
    },
  });

  // Button + shortcut entry point. The title-empty case can't rely on the
  // button tooltip (shortcuts bypass the button), so focus the title to point
  // at the fix; otherwise hand off to the composer (single-flight + gate live
  // there).
  const handleSubmit = () => {
    if (!title.trim()) {
      titleEditorRef.current?.focus();
      return;
    }
    void composer.submit();
  };
  const submitting = composer.submitting;

  // Switch to agent mode WITHOUT destroying the manual draft. The manual slot
  // (title, description, …) is left untouched so a later agent→manual flip
  // restores it verbatim. Project / priority / due date already live in the
  // shared slot, so they carry across for free. Only two things are handed to
  // the agent panel:
  //   1. A one-time assist-init of the agent prompt / actor: when the agent
  //      draft is still empty, seed the prompt from title + description and the
  //      actor from the manual assignee (if agent-like). An existing agent
  //      draft is preserved — no repeated concatenate-then-clobber.
  //   2. The parent-issue context, which is not persisted in the draft (it is a
  //      per-invocation intent from "Add sub issue"), so it rides the carry.
  const switchToAgent = () => {
    // Serializing mid-upload packs a description that has already lost the
    // pending image into the agent prompt, so gate the switch too.
    if (gate.isBlocked()) return;
    // Commit the shared fields to the draft so the agent panel reads them from
    // there. Local state can hold a value seeded from `data` (e.g. an opener's
    // project) that was never written through a picker, so a plain flip would
    // otherwise drop it.
    setShared({ projectId, priority, dueDate });
    const existingPrompt = draft.agent.prompt;
    if (!existingPrompt.trim()) {
      // KD5: the agent-mode panel has no skill designation (its @ menu
      // suppresses skill rows), so the manual description's skill chips
      // must cross the switch as plain text — the dead affordance must
      // not reach the agent prompt. Other mention types stay as live chips
      // since the agent panel still surfaces them.
      const desc =
        stripSkillMentionMarkdown(
          descEditorRef.current?.getMarkdown()?.trim() ?? "",
        );
      const seeded = [title.trim(), desc].filter(Boolean).join("\n\n");
      if (seeded) setAgent({ prompt: seeded });
    }
    if (
      !draft.agent.actorId &&
      assigneeId &&
      (assigneeType === "agent" || assigneeType === "squad")
    ) {
      setAgent({ actorType: assigneeType, actorId: assigneeId });
    }
    setLastMode("agent");
    setActiveMode("agent");
    // Prefer the hydrated identifier from `parentIssue`, but fall back to the
    // identifier the modal opener seeded on `data`. Without the fallback, a
    // flip that happens before the issue detail query resolves drops the
    // identifier and the agent chip renders as "Sub-issue of " with an empty
    // tail. The UUID alone still wires the sub-issue relationship correctly;
    // this only affects the display affordance.
    const carryParentIdentifier =
      parentIssue?.identifier ?? (data?.parent_issue_identifier as string | undefined);
    const carry: Record<string, unknown> = {};
    if (parentIssueId) carry.parent_issue_id = parentIssueId;
    if (carryParentIdentifier) carry.parent_issue_identifier = carryParentIdentifier;
    onSwitchMode?.(Object.keys(carry).length > 0 ? carry : null);
  };

  // One state for the button and the keyboard paths, so a rendered affordance
  // can never disagree with what `handleSubmit` will actually do.
  const submitState: "submitting" | "uploading" | "missing_title" | "ready" =
    submitting
      ? "submitting"
      : gate.uploading
        ? "uploading"
        : !title.trim()
          ? "missing_title"
          : "ready";
  const submitBusy = submitState === "submitting" || submitState === "uploading";

  // Built once and reused by both footer branches: rendering a separate Button
  // per branch is how the keycaps drifted out of one of them before.
  const createButton = (
    <Button
      size="sm"
      onClick={handleSubmit}
      // Native `disabled` for the transient busy states, but `aria-disabled`
      // for a missing title — a native-disabled button is not focusable, so
      // keyboard and screen-reader users could never reach the tooltip that
      // explains why nothing happens. `handleSubmit` is the real gate either way.
      disabled={submitBusy}
      aria-disabled={submitState === "missing_title" || undefined}
      aria-busy={submitBusy || undefined}
      // The Button base only dims/blocks on native `disabled`, so aria-disabled
      // would otherwise stay a fully lit, pressable-looking primary button.
      // Deliberately no `pointer-events-none`: this control still has to hover
      // its tooltip and take the click that focuses the title.
      className="justify-self-end aria-disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:active:translate-y-0"
    >
      {submitState === "submitting" ? (
        t(($) => $.create_issue.submitting)
      ) : submitState === "uploading" ? (
        tEditor(($) => $.upload.in_progress)
      ) : (
        <>
          {t(($) => $.create_issue.submit)}
          {/* Decorative: the accessible name must stay "Create Issue", not
              "Create Issue Command Enter". Absent when `send` is unbound.
              Hidden on phones — no ⌘ key there, and the footer row is at its
              tightest. */}
          {sendShortcut ? (
            <ShortcutKeycaps
              shortcut={sendShortcut}
              decorative
              className="ml-1 max-sm:hidden"
              keyClassName="border-background/30 bg-background/15 text-primary-foreground shadow-none"
            />
          ) : null}
        </>
      )}
    </Button>
  );

  return (
    <>
            <DialogTitle className="sr-only">{t(($) => $.create_issue.sr_manual)}</DialogTitle>

            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-3 pb-2 shrink-0">
              <div className="flex items-center gap-1.5 text-caption">
                <span className="text-muted-foreground">{workspaceName}</span>
                <ChevronRight className="size-3 text-faint-foreground" />
                <span className="font-medium">{t(($) => $.create_issue.manual_breadcrumb)}</span>
              </div>
              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="rounded-sm p-1.5 opacity-70 hover:opacity-100 hover:bg-accent/60 transition-all cursor-pointer"
                      >
                        {isExpanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                      </button>
                    }
                  />
                  <TooltipContent side="bottom">
                    {isExpanded
                      ? t(($) => $.common.collapse_tooltip)
                      : t(($) => $.common.expand_tooltip)}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={onClose}
                        className="rounded-sm p-1.5 opacity-70 hover:opacity-100 hover:bg-accent/60 transition-all cursor-pointer"
                      >
                        <XIcon className="size-4" />
                      </button>
                    }
                  />
                  <TooltipContent side="bottom">{t(($) => $.common.close)}</TooltipContent>
                </Tooltip>
              </div>
            </div>

            {/* Title */}
            <div className="px-5 pb-2 shrink-0">
              <TitleEditor
                key={formResetKey}
                ref={titleEditorRef}
                autoFocus
                defaultValue={draft.manual.title}
                placeholder={t(($) => $.create_issue.title_placeholder)}
                className="text-title font-semibold"
                onChange={(v) => updateTitle(v)}
                // Chord only — plain Enter still just ends title editing (#5532).
                onSubmitShortcut={handleSubmit}
              />
            </div>

            {/* Description — takes remaining space */}
            <div {...descDropZoneProps} className="relative flex flex-1 min-h-0 overflow-y-auto px-5">
              <ContentEditor
                ref={descEditorRef}
                defaultValue={draft.manual.description}
                placeholder={t(($) => $.create_issue.description_placeholder)}
                onUpdate={(md) => {
                  setManual({ description: md });
                  // Mirror the editor's markdown into local state (U5) so the
                  // recommendation engine sees freshly-typed mentions on its
                  // next render — the persisted draft store is the source of
                  // truth, but the local mirror closes the live-update gap.
                  setDescriptionMirror(md);
                  // U5: the auto-bind engine syncs its `docSkillIds` view of
                  // the editor on every update tick so the fill effect sees
                  // chip insertions/removals immediately.
                  syncSkillMentionsWithDoc();
                }}
                onSubmit={handleSubmit}
                onUploadFile={handleUpload}
                onUploadingChange={uploadGate.onUploadingChange}
                debounceMs={500}
                attachments={draftAttachments}
                skillMentionContext={{
                  wsId,
                  skillMentionAgents,
                  onSkillMentionChange: handleSkillMentionChange,
                  openPopoverFor,
                  setOpenPopoverFor,
                }}
                onSkillMentionInserted={handleSkillMentionInserted}
              />
              {descDragOver && <FileDropOverlay />}
            </div>


            {/* Pre-trigger preview — a passive caption above the toolbar; reveals
                when an agent assignee will pick the issue up, and (U7) renders
                the client-side designation lines for every touched @skill chip. */}
            <CreateRunHint
              assigneeType={assigneeType}
              assigneeId={assigneeId}
              status={status}
              designations={designationHints}
              unresolvedSkillLabels={unresolvedSkillLabels}
            />

            {/* Property toolbar — each field renders per the Settings → Issue
                selection (see showField above). */}
            <div className="flex items-center gap-1.5 px-4 py-2 shrink-0 flex-wrap">
              {/* Status */}
              {showField.status && (
                <StatusPicker
                  status={status}
                  onUpdate={(u) => { if (u.status) updateStatus(u.status); }}
                  triggerRender={<PillButton />}
                  align="start"
                  open={fieldPickerOpen === "status" ? true : undefined}
                  onOpenChange={(open) => setFieldPickerOpen(open ? "status" : null)}
                />
              )}

              {/* Priority */}
              {showField.priority && (
                <PriorityPicker
                  priority={priority}
                  onUpdate={(u) => { if (u.priority) updatePriority(u.priority); }}
                  triggerRender={<PillButton />}
                  align="start"
                  open={fieldPickerOpen === "priority" ? true : undefined}
                  onOpenChange={(open) => setFieldPickerOpen(open ? "priority" : null)}
                />
              )}

              {/* Assignee */}
              {showField.assignee && (
                <AssigneePicker
                  assigneeType={assigneeType ?? null}
                  assigneeId={assigneeId ?? null}
                  onUpdate={(u) => updateAssignee(
                    u.assignee_type ?? undefined,
                    u.assignee_id ?? undefined,
                  )}
                  triggerRender={<PillButton />}
                  align="start"
                  open={fieldPickerOpen === "assignee" ? true : undefined}
                  onOpenChange={(open) => setFieldPickerOpen(open ? "assignee" : null)}
                />
              )}

              {/* Labels — occupies the slot that used to hold Due date so the
                  add-label entry is exposed directly on the dialog. Draft mode:
                  selection is local until the issue is created (handleSubmit
                  attaches the labels afterward). */}
              {showField.labels && (
                <LabelPicker
                  selectedIds={labelIds}
                  onSelectedIdsChange={updateLabelIds}
                  triggerRender={<PillButton />}
                  align="start"
                  open={fieldPickerOpen === "labels" ? true : undefined}
                  onOpenChange={(open) => setFieldPickerOpen(open ? "labels" : null)}
                />
              )}

              {/* Project */}
              {showField.project && (
                <ProjectPicker
                  projectId={projectId ?? null}
                  onUpdate={(u) => updateProject(u.project_id ?? undefined)}
                  triggerRender={
                    <ClearablePillButton
                      onClear={projectId ? () => updateProject(undefined) : undefined}
                      clearLabel={tProjects(($) => $.picker.clear_aria)}
                    />
                  }
                  align="start"
                  open={fieldPickerOpen === "project" ? true : undefined}
                  onOpenChange={(open) => setFieldPickerOpen(open ? "project" : null)}
                />
              )}

              {/* Stage — only relevant when creating a sub-issue under a parent */}
              {parentIssueId && (
                <StagePicker
                  stage={stage}
                  onUpdate={(u) => setStage(u.stage ?? null)}
                  maxStage={maxSiblingStage(parentChildren)}
                  triggerRender={<PillButton />}
                  align="start"
                />
              )}

              {/* Start date — collapsed into the ⋯ menu by default since it's
                  a low-frequency field (exposable via Settings → Issue).
                  Renders inline when configured visible, when the field has a
                  value, OR when the user just opened it from the overflow
                  menu (the picker's calendar popover needs the inline pill
                  as its anchor). */}
              {showField.start_date && (
                <StartDatePicker
                  startDate={startDate}
                  onUpdate={(u) => updateStartDate(u.start_date ?? null)}
                  triggerRender={<PillButton />}
                  align="start"
                  open={startDatePickerOpen}
                  onOpenChange={setStartDatePickerOpen}
                />
              )}

              {/* Due date — collapsed into the ⋯ menu by default (moved off
                  the toolbar to make room for Labels). Same reveal rule as
                  start date. */}
              {showField.due_date && (
                <DueDatePicker
                  dueDate={dueDate}
                  onUpdate={(u) => updateDueDate(u.due_date ?? null)}
                  triggerRender={<PillButton />}
                  align="start"
                  open={dueDatePickerOpen}
                  onOpenChange={setDueDatePickerOpen}
                />
              )}

              {/* Workspace-defined fields use the same typed editors as issue
                  detail, but write into the persisted draft until creation. */}
              {workspaceProperties
                .filter(
                  (property) =>
                    Object.prototype.hasOwnProperty.call(propertyValues, property.id) ||
                    customPropertyPickerId === property.id,
                )
                .map((property) => {
                  const value = propertyValues[property.id];
                  return (
                    <CustomPropertyValueInput
                      key={property.id}
                      property={property}
                      value={value}
                      onChange={(next) => updatePropertyValue(property.id, next)}
                      open={customPropertyPickerId === property.id}
                      onOpenChange={(open) =>
                        setCustomPropertyPickerId(open ? property.id : null)
                      }
                      triggerRender={<PillButton />}
                      trigger={
                        <>
                          <PropertyIcon property={property} className="size-3.5 text-caption" />
                          <span className="max-w-32 truncate">{property.name}</span>
                          {value !== undefined && (
                            <span className="max-w-40 truncate text-muted-foreground">
                              <CustomPropertyValueDisplay property={property} value={value} />
                            </span>
                          )}
                        </>
                      }
                    />
                  );
                })}

              {/* Parent chip — appears when parent is set.
                  Placed before the ⋯ so it wraps to a new line with ⋯ if
                  space is tight, but ⋯ always stays last in DOM order. */}
              {parentIssueId && parentIssue && (
                <div className="inline-flex items-center rounded-full border text-caption transition-colors hover:bg-accent/60">
                  <button
                    type="button"
                    onClick={() => setParentPickerOpen(true)}
                    className="flex items-center gap-1.5 py-1 pl-2.5 cursor-pointer"
                  >
                    <ArrowUp className="size-3 text-muted-foreground" />
                    <span>
                      {t(($) => $.create_issue.subissue_of, { identifier: parentIssue.identifier })}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setParentIssueId(undefined)}
                    className="p-1 pr-2 text-muted-foreground hover:text-foreground cursor-pointer"
                    aria-label={t(($) => $.create_issue.remove_parent_aria)}
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              )}

              {/* Child chips — one per queued sub-issue. Links are deferred
                  until create resolves (see handleSubmit). */}
              {childIssues.map((c) => (
                <div
                  key={c.id}
                  className="inline-flex items-center rounded-full border text-caption transition-colors hover:bg-accent/60"
                >
                  <div className="flex items-center gap-1.5 py-1 pl-2.5">
                    <ArrowDown className="size-3 text-muted-foreground" />
                    <span>{t(($) => $.create_issue.subissue_chip, { identifier: c.identifier })}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setChildIssues((prev) => prev.filter((x) => x.id !== c.id))
                    }
                    className="p-1 pr-2 text-muted-foreground hover:text-foreground cursor-pointer"
                    aria-label={t(($) => $.create_issue.remove_subissue_aria, { identifier: c.identifier })}
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              ))}

              {/* Overflow — always the last child so DOM order keeps it at the
                  end of the wrap flow, no matter how many chips are present. */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <PillButton aria-label={t(($) => $.create_issue.more_options_aria)}>
                      <MoreHorizontal className="size-3.5" />
                    </PillButton>
                  }
                />
                <DropdownMenuContent align="start" className="w-auto">
                  {/* Re-entry points for toolbar fields hidden via
                      Settings → Issue. Listed in toolbar order; each opens
                      the picker inline (mounting the pill as its anchor). */}
                  {!showField.status && (
                    <DropdownMenuItem onClick={() => setFieldPickerOpen("status")}>
                      <StatusIcon status={status} className="h-3.5 w-3.5" />
                      {t(($) => $.create_issue.set_status)}
                    </DropdownMenuItem>
                  )}
                  {!showField.priority && (
                    <DropdownMenuItem onClick={() => setFieldPickerOpen("priority")}>
                      <PriorityIcon priority="none" className="h-3.5 w-3.5" />
                      {t(($) => $.create_issue.set_priority)}
                    </DropdownMenuItem>
                  )}
                  {!showField.assignee && (
                    <DropdownMenuItem onClick={() => setFieldPickerOpen("assignee")}>
                      <CircleUser className="h-3.5 w-3.5" />
                      {t(($) => $.create_issue.set_assignee)}
                    </DropdownMenuItem>
                  )}
                  {!showField.labels && (
                    <DropdownMenuItem onClick={() => setFieldPickerOpen("labels")}>
                      <Tag className="h-3.5 w-3.5" />
                      {t(($) => $.create_issue.set_labels)}
                    </DropdownMenuItem>
                  )}
                  {!showField.project && (
                    <DropdownMenuItem onClick={() => setFieldPickerOpen("project")}>
                      <FolderKanban className="h-3.5 w-3.5" />
                      {t(($) => $.create_issue.set_project)}
                    </DropdownMenuItem>
                  )}
                  {!showField.due_date && (
                    <DropdownMenuItem onClick={() => setDueDatePickerOpen(true)}>
                      <CalendarDays className="h-3.5 w-3.5" />
                      {t(($) => $.create_issue.set_due_date)}
                    </DropdownMenuItem>
                  )}
                  {!showField.start_date && (
                    <DropdownMenuItem onClick={() => setStartDatePickerOpen(true)}>
                      <CalendarClock className="h-3.5 w-3.5" />
                      {t(($) => $.create_issue.set_start_date)}
                    </DropdownMenuItem>
                  )}
                  {parentIssueId && parentIssue ? (
                    <DropdownMenuItem onClick={() => setParentPickerOpen(true)}>
                      <ArrowUp className="h-3.5 w-3.5" />
                      {t(($) => $.create_issue.parent_with_id, { identifier: parentIssue.identifier })}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onClick={() => setParentPickerOpen(true)}>
                      <ArrowUp className="h-3.5 w-3.5" />
                      {t(($) => $.create_issue.set_parent)}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => setChildPickerOpen(true)}>
                    <ArrowDown className="h-3.5 w-3.5" />
                    {t(($) => $.create_issue.add_subissue)}
                  </DropdownMenuItem>
                  {workspaceProperties.length > 0 && (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <Shapes className="h-3.5 w-3.5" />
                        {t(($) => $.create_issue.custom_properties)}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="w-56">
                        {workspaceProperties.map((property) => (
                          <DropdownMenuItem
                            key={property.id}
                            disabled={Object.prototype.hasOwnProperty.call(
                              propertyValues,
                              property.id,
                            )}
                            onClick={() => setCustomPropertyPickerId(property.id)}
                          >
                            <PropertyIcon property={property} className="size-3.5 text-caption" />
                            <span className="truncate">{property.name}</span>
                            {Object.prototype.hasOwnProperty.call(
                              propertyValues,
                              property.id,
                            ) && <Check className="ml-auto size-3.5" />}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  )}
                  <DropdownMenuSeparator />
                  {/* Field visibility lives in Settings → Issue; the modal
                      closes first so the dialog doesn't linger over the
                      settings page. The draft store already holds everything
                      typed, so nothing is lost across the round-trip. */}
                  <DropdownMenuItem
                    render={
                      <AppLink
                        href={`${p.settings()}?tab=issue`}
                        onClick={(e) => {
                          // A modifier click opens Settings in another tab —
                          // the modal (and the draft in it) stays put. Only
                          // an in-place navigation closes it.
                          if (resolveClickIntent(e) !== "push") return;
                          onClose();
                        }}
                      />
                    }
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                    {t(($) => $.create_issue.customize_fields)}
                  </DropdownMenuItem>
                  {parentIssueId && parentIssue && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setParentIssueId(undefined)}
                      >
                        <XIcon className="h-3.5 w-3.5" />
                        {t(($) => $.create_issue.remove_parent)}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Parent / child pickers — rendered inline so they stack over this
                modal instead of replacing it via useModalStore. */}
            <IssuePickerModal
              open={parentPickerOpen}
              onOpenChange={setParentPickerOpen}
              title={t(($) => $.create_issue.set_parent_picker.title)}
              description={t(($) => $.create_issue.set_parent_picker.description)}
              excludeIds={[
                ...childIssues.map((c) => c.id),
                ...(parentIssueId ? [parentIssueId] : []),
              ]}
              onSelect={(selected) => {
                setParentIssueId(selected.id);
              }}
            />
            <IssuePickerModal
              open={childPickerOpen}
              onOpenChange={setChildPickerOpen}
              title={t(($) => $.create_issue.add_subissue_picker.title)}
              description={t(($) => $.create_issue.add_subissue_picker.description)}
              excludeIds={[
                ...childIssues.map((c) => c.id),
                ...(parentIssueId ? [parentIssueId] : []),
              ]}
              onSelect={(selected) => {
                setChildIssues((prev) =>
                  prev.some((x) => x.id === selected.id) ? prev : [...prev, selected],
                );
              }}
            />

            {/* Footer — same 2x2-grid-on-phones / single-row-from-`sm` shape
                as the agent panel; see the note on AgentCreatePanel's footer
                for why (MUL-6236). TooltipProvider/Tooltip render no DOM and
                TooltipContent is portaled, so the Create button stays a direct
                grid child in both branches below. */}
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-2.5 border-t px-4 py-3 shrink-0 sm:flex sm:flex-wrap">
              <div className="flex min-h-7 items-center gap-2 sm:mr-auto">
                <FileUploadButton
                  multiple
                  onSelect={(file) => descEditorRef.current?.uploadFile(file)}
                />
              </div>
              <button
                type="button"
                onClick={switchToAgent}
                disabled={gate.uploading}
                aria-disabled={gate.uploading || undefined}
                aria-busy={gate.uploading || undefined}
                title={t(($) => $.create_issue.switch_to_agent_tooltip)}
                className="border-beam group flex shrink-0 items-center gap-1.5 justify-self-end text-caption px-2 py-1 rounded-sm text-muted-foreground bg-brand/5 hover:bg-brand/10 hover:text-foreground transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ArrowLeftRight className="size-3.5 text-brand transition-transform duration-300 group-hover:rotate-180" />
                {t(($) => $.create_issue.switch_to_agent)}
              </button>
              <label className="flex shrink-0 items-center gap-1.5 text-caption text-muted-foreground cursor-pointer select-none">
                <Switch
                  size="sm"
                  checked={keepOpen}
                  onCheckedChange={setKeepOpen}
                />
                {t(($) => $.create_issue.create_another)}
              </label>
              {submitState === "missing_title" ? (
                <TooltipProvider delay={200}>
                  <Tooltip>
                    {/* No `<span>` wrapper needed now: aria-disabled leaves the
                        button focusable and hoverable, so it can anchor its own
                        tooltip. */}
                    <TooltipTrigger render={createButton} />
                    <TooltipContent side="top">{t(($) => $.create_issue.title_required)}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : (
                createButton
              )}
            </div>
    </>
  );
}

/** className for DialogContent in manual mode — depends on isExpanded.
 *  Exported so the shell (which now owns the DialogContent) can apply the same
 *  visual treatment without duplicating it. */
export function manualDialogContentClass(isExpanded: boolean) {
  return cn(
    "p-0 gap-0 flex flex-col overflow-hidden",
    "!top-1/2 !left-1/2 !-translate-x-1/2",
    "!transition-all !duration-300 !ease-out",
    // Phone gutter — see the matching note in create-issue-dialog.tsx: the
    // `!important` widths below also override DialogContent's
    // `max-w-[calc(100%-2rem)]`, leaving the card edge to edge on a phone
    // (MUL-6236). `!h-96` stays a hard height; it already fits the shortest
    // phone we support.
    "!w-full !max-w-[calc(100vw-1.5rem)]",
    isExpanded
      ? "!h-5/6 !-translate-y-1/2 sm:!max-w-4xl"
      : "!h-96 !-translate-y-1/2 sm:!max-w-2xl",
  );
}

// Thin Dialog-wrapping export — registry mounts the panel directly under the
// shell's shared Dialog, but a few legacy callers (and the test suite) still
// import this module's modal version. Equivalent runtime behavior to the
// pre-refactor component when used standalone.
import { Dialog as DialogRoot } from "@multica/ui/components/ui/dialog";
export function CreateIssueModal(props: {
  onClose: () => void;
  data?: Record<string, unknown> | null;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  return (
    <DialogRoot open onOpenChange={(v) => { if (!v) props.onClose(); }}>
      <DialogContent
        finalFocus={false}
        showCloseButton={false}
        className={manualDialogContentClass(isExpanded)}
      >
        <ManualCreatePanel
          {...props}
          isExpanded={isExpanded}
          setIsExpanded={setIsExpanded}
        />
      </DialogContent>
    </DialogRoot>
  );
}
