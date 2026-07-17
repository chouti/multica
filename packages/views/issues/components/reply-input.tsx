"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { ContentEditor, type ContentEditorRef, useFileDropZone, FileDropOverlay, useLazyEditor, useUploadGate, useEditorUpload } from "../../editor";
import { FileUploadButton } from "@multica/ui/components/common/file-upload-button";
import { SubmitButton } from "@multica/ui/components/common/submit-button";
import { ActorAvatar } from "../../common/actor-avatar";
import type { Attachment } from "@multica/core/types";
import { contentReferencesAttachment } from "@multica/core/types";
import { formatShortcut, useShortcut } from "@multica/core/shortcuts";
import { useCommentDraftStore, type CommentDraftKey } from "@multica/core/issues/stores";
import { useWorkspaceId } from "@multica/core/hooks";
import { cn } from "@multica/ui/lib/utils";
import type { AvatarSize } from "@multica/ui/lib/avatar-size";
import { useT } from "../../i18n";
import { CommentTriggerChips } from "./comment-trigger-chips";
import { useCommentTriggerPreview } from "../hooks/use-comment-trigger-preview";
import { useSkillDesignatedPreviewAgents } from "../hooks/use-skill-designated-preview-agents";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReplyInputProps {
  issueId: string;
  parentId: string;
  placeholder?: string;
  avatarType: string;
  avatarId: string;
  /** Resolves true on success, false on failure — the reply box keeps its text
   *  (locked + spinning) until then, clearing only on success. */
  onSubmit: (content: string, attachmentIds?: string[], suppressAgentIds?: string[], skillMentionAgents?: Record<string, string[]>) => Promise<boolean>;
  size?: "sm" | "default";
  /** When set, hydrates/persists the in-progress reply via the draft store.
   *  Required for replies inside virtualized timeline threads, where the
   *  enclosing CommentCard may unmount on scroll-out. */
  draftKey?: CommentDraftKey;
}

// ---------------------------------------------------------------------------
// ReplyInput
// ---------------------------------------------------------------------------

function ReplyInput({
  issueId,
  parentId,
  placeholder,
  avatarType,
  avatarId,
  onSubmit,
  size = "default",
  draftKey,
}: ReplyInputProps) {
  const { t } = useT("issues");
  const { t: tEditor } = useT("editor");
  const wsId = useWorkspaceId();
  const sendShortcut = useShortcut("send");
  const placeholderText = placeholder ?? t(($) => $.reply.placeholder);
  const editorRef = useRef<ContentEditorRef>(null);
  // See CommentInput — replying mid-upload posts without the file.
  const uploadGate = useUploadGate(editorRef);
  // If a draft key is provided, hydrate from store on mount (defaultValue is
  // the only injection point on ContentEditorRef) and flush on every onUpdate.
  const initialDraftPayload = draftKey
    ? useCommentDraftStore.getState().getDraftPayload(draftKey)
    : undefined;
  const initialDraft = initialDraftPayload?.content;
  const [content, setContent] = useState(initialDraft ?? "");
  const setDraft = useCommentDraftStore((s) => s.setDraft);
  const clearDraft = useCommentDraftStore((s) => s.clearDraft);
  const [isEmpty, setIsEmpty] = useState(!initialDraft?.trim());
  const [submitting, setSubmitting] = useState(false);
  const [suppressedAgentIds, setSuppressedAgentIds] = useState<Set<string>>(() => new Set());
  // Restore the persisted skill-mention designation map alongside the
  // content so a reloaded draft rehydrates the user's chip-by-chip
  // designations (review finding #7).
  const [skillMentionAgents, setSkillMentionAgents] = useState<Record<string, string[]>>(
    initialDraftPayload?.skillMentionAgents ?? {},
  );
  // Composer-owned popover-open state, keyed by skill id (see comment-input).
  const [openPopoverFor, setOpenPopoverFor] = useState<string | null>(null);
  // Skill-designated agents surfaced as preview chips (see comment-input).
  const skillDesignatedAgents = useSkillDesignatedPreviewAgents(wsId, skillMentionAgents);
  const triggerPreview = useCommentTriggerPreview({
    issueId,
    parentId,
    content,
    skillDesignatedAgents,
  });
  // Attachments uploaded in this composer session — see CommentInput for the
  // rationale (drives both submit-time attachment_ids and editor previews).
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const { uploadWithToast } = useEditorUpload();
  // Readonly-first: static shell until intent; an unsent draft mounts the
  // real editor immediately (see CommentInput). This is also what keeps the
  // reply box working across Virtuoso scroll-out — a typed draft rehydrates
  // into a live editor when the card remounts, an untouched box folds back
  // to the shell.
  const lazy = useLazyEditor({
    initialActive: !!initialDraft?.trim(),
    editorRef,
  });
  const { isDragOver, dropZoneProps } = useFileDropZone({
    onDrop: lazy.uploadOrQueue,
  });

  // Flush on tab close / mobile background — same rationale as CommentInput.
  useEffect(() => {
    if (!draftKey) return;
    const flush = () => {
      const md = editorRef.current?.getMarkdown();
      if (md && md.trim().length > 0) {
        // Persist content + skill-mention designations together so a
        // restored draft rehydrates both (review finding #7).
        setDraft(draftKey, { content: md, skillMentionAgents });
      }
    };
    const onVis = () => { if (document.visibilityState === "hidden") flush(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", flush);
    };
  }, [draftKey, setDraft]);

  const handleUpload = useCallback(async (file: File) => {
    const result = await uploadWithToast(file, { issueId });
    if (result) {
      setPendingAttachments((prev) => [...prev, result]);
    }
    return result;
  }, [uploadWithToast, issueId]);

  useEffect(() => {
    setSuppressedAgentIds(new Set());
    setSkillMentionAgents({});
  }, [issueId, parentId]);

  useEffect(() => {
    const visible = new Set(triggerPreview.agents.map((agent) => agent.id));
    setSuppressedAgentIds((prev) => {
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [triggerPreview.agents]);

  const toggleSuppressedAgent = useCallback((agentId: string) => {
    setSuppressedAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }, []);

  const handleSkillMentionChange = useCallback((skillId: string, agentIds: string[]) => {
    setSkillMentionAgents((prev) => {
      const next = { ...prev };
      if (agentIds.length > 0) next[skillId] = agentIds;
      else delete next[skillId];
      return next;
    });
  }, []);

  // Text-gesture consistency: when a skill mention disappears from the editor
  // document, drop its designation state too.
  const syncSkillMentionsWithDoc = useCallback(() => {
    const ids = new Set(editorRef.current?.getSkillMentionIds() ?? []);
    setSkillMentionAgents((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id)));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, []);

  const handleSubmit = async () => {
    const content = editorRef.current?.getMarkdown()?.replace(/(\n\s*)+$/, "").trim();
    if (!content || submitting) return;
    // Submit-time re-read — the shortcut path never sees the disabled button.
    if (uploadGate.isBlocked()) return;
    // Track every attachment whose stable download URL OR legacy
    // storage URL is referenced in the markdown body. Both shapes
    // can appear in the same comment during the MUL-3130 rollout.
    const activeIds = pendingAttachments
      .filter((a) => contentReferencesAttachment(content, a))
      .map((a) => a.id);
    const suppressAgentIds = triggerPreview.agents
      .filter((agent) => suppressedAgentIds.has(agent.id))
      .map((agent) => agent.id);
    // U3: forward the composer-held designation map (skill id -> agent ids).
    // Entries are pruned as skill chips disappear from the document, so the
    // map is already in sync with what the user sees.
    const skillMentionAgentsPayload =
      Object.keys(skillMentionAgents).length > 0 ? skillMentionAgents : undefined;
    // Pessimistic submit (see CommentInput): keep the text, lock + spin, clear
    // only once the server accepts it.
    setSubmitting(true);
    try {
      const ok = await onSubmit(
        content,
        activeIds.length > 0 ? activeIds : undefined,
        suppressAgentIds.length > 0 ? suppressAgentIds : undefined,
        skillMentionAgentsPayload,
      );
      if (ok) {
        editorRef.current?.clearContent();
        setContent("");
        setIsEmpty(true);
        setSuppressedAgentIds(new Set());
        setSkillMentionAgents({});
        setPendingAttachments([]);
        if (draftKey) clearDraft(draftKey);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const avatarSize: AvatarSize = size === "sm" ? "sm" : "md";

  return (
    <div className="group/editor flex items-start gap-2.5">
      <ActorAvatar
        actorType={avatarType}
        actorId={avatarId}
        size={avatarSize}
        className="mt-0.5 shrink-0"
      />
      <div
        {...dropZoneProps}
        className={cn(
          "relative min-w-0 flex-1 flex flex-col",
          !isEmpty && "pb-9",
        )}
      >
        {/* Lock the editor while the reply is in flight — see CommentInput. */}
        {lazy.active && (
        <div
          className={cn(
            "flex-1 min-h-0 overflow-y-auto",
            submitting && "pointer-events-none opacity-60",
            !lazy.ready && "hidden",
          )}
          aria-busy={submitting || undefined}
        >
          <ContentEditor
            ref={editorRef}
            defaultValue={initialDraft}
            onReady={lazy.onReady}
            placeholder={placeholderText}
            onUpdate={(md) => {
              setContent(md);
              setIsEmpty(!md.trim());
              if (draftKey) {
                if (md.trim().length > 0) {
                  setDraft(draftKey, { content: md, skillMentionAgents });
                } else {
                  clearDraft(draftKey);
                }
              }
              syncSkillMentionsWithDoc();
            }}
            onSubmit={handleSubmit}
            onUploadFile={handleUpload}
            onUploadingChange={uploadGate.onUploadingChange}
            debounceMs={100}
            currentIssueId={issueId}
            attachments={pendingAttachments}
            enableSlashCommands
            slashCommandMode="command"
            skillMentionContext={{
              wsId,
              skillMentionAgents,
              onSkillMentionChange: handleSkillMentionChange,
              openPopoverFor,
              setOpenPopoverFor,
            }}
          />
        </div>
        )}
        {/* Static shell — clones the empty single-line reply box (see
            CommentInput for the pattern). */}
        {!lazy.ready && (
          <div
            data-testid="reply-composer-shell"
            role="button"
            tabIndex={0}
            aria-label={placeholderText}
            className="flex-1 min-h-0 cursor-text rich-text-editor text-sm"
            onClick={() => lazy.activate()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                lazy.activate();
              }
            }}
          >
            {/* <p> under rich-text-editor: same type metrics as the real
                editor's empty paragraph — no height jump on swap. */}
            <p className="text-muted-foreground">{placeholderText}</p>
          </div>
        )}
        <div className="absolute bottom-0 left-0 right-24 min-w-0">
          <CommentTriggerChips
            agents={triggerPreview.agents}
            blocked={triggerPreview.blocked}
            draftContent={content}
            suppressedAgentIds={suppressedAgentIds}
            onToggle={toggleSuppressedAgent}
          />
        </div>
        <div className="absolute bottom-0 right-0 flex items-center gap-1">
          <FileUploadButton
            size="sm"
            multiple
            onSelect={(file) => lazy.uploadOrQueue([file])}
          />
          <SubmitButton
            onClick={handleSubmit}
            disabled={isEmpty}
            loading={submitting}
            busy={uploadGate.uploading}
            tooltip={uploadGate.uploading
              ? tEditor(($) => $.upload.in_progress)
              : sendShortcut
                ? `${t(($) => $.comment.send_tooltip)} · ${formatShortcut(sendShortcut)}`
                : t(($) => $.comment.send_tooltip)}
            ariaLabel={uploadGate.uploading
              ? tEditor(($) => $.upload.in_progress)
              : t(($) => $.comment.send_tooltip)}
          />
        </div>
        {isDragOver && <FileDropOverlay />}
      </div>
    </div>
  );
}

export { ReplyInput, type ReplyInputProps };
