import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { forwardRef, useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TimelineEntry } from "@multica/core/types";
import type { UploadResult } from "@multica/core/hooks/use-file-upload";
import { useCommentDraftStore } from "@multica/core/issues/stores";
import { renderWithI18n } from "../../test/i18n";

const apiUploadFile = vi.hoisted(() => vi.fn());
const apiListAgents = vi.hoisted(() => vi.fn());
const uploadWithToast = vi.hoisted(() => vi.fn());

let mockUploadIdSeq = 0;

vi.mock("@multica/core/api", () => ({
  // Uploads flow through the coordinator, which calls api.uploadFile (MUL-5181);
  // listAgents serves the skill-designation preview strip (see
  // use-skill-designated-preview-agents), which enables once a reply's skill
  // mention designates an agent.
  api: { uploadFile: apiUploadFile, listAgents: apiListAgents, listTaskMessages: vi.fn() },
  dispatchReasonCode: () => undefined,
}));

vi.mock("../../navigation", () => ({
  useNavigation: () => ({
    push: vi.fn(),
    pathname: "/acme/issues",
    getShareableUrl: (p: string) => `https://app.example${p}`,
  }),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: () => "Ada" }),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: () => null,
}));

// The trigger-preview chips have their own suite; inert here so this file
// stays about the reply -> onReply skill-designation forwarding.
vi.mock("../hooks/use-comment-trigger-preview", () => ({
  useCommentTriggerPreview: () => ({ agents: [], blocked: [] }),
}));

vi.mock("../../editor", async () => ({
  // The card nests a ReplyInput, which is readonly-first — real controller.
  ...(await vi.importActual<typeof import("../../editor/use-lazy-editor")>(
    "../../editor/use-lazy-editor",
  )),
  // Real submit gate (pure React) driven by the mock editor below.
  ...(await vi.importActual<typeof import("../../editor/use-upload-gate")>(
    "../../editor/use-upload-gate",
  )),
  // Real await-then-render submit contract (pure React).
  ...(await vi.importActual<typeof import("../../editor/use-composer-submit")>(
    "../../editor/use-composer-submit",
  )),
  useEditorUpload: () => ({ uploadWithToast, upload: vi.fn(), uploading: false }),
  useFileDropZone: () => ({ isDragOver: false, dropZoneProps: {} }),
  FileDropOverlay: () => null,
  ReadonlyContent: ({ content }: { content: string }) => <div>{content}</div>,
  Attachment: () => null,
  AttachmentDownloadProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  // Same textarea stand-in as the sibling composer suites, plus the
  // skill-mention harness controls: ReplyInput has no editorComponent seam, so
  // the skill-mention gesture is exposed as test buttons on the editor itself.
  ContentEditor: forwardRef(function SkillMentionEditor(
    {
      defaultValue,
      onUpdate,
      onSubmit,
      onUploadFile,
      onUploadingChange,
      onReady,
      skillMentionContext,
    }: {
      defaultValue?: string;
      onUpdate?: (markdown: string) => void;
      onUploadFile?: (file: File, uploadId: string) => Promise<UploadResult | null>;
      onUploadingChange?: (uploading: boolean) => void;
      onSubmit?: () => void;
      onReady?: () => void;
      skillMentionContext?: {
        wsId: string;
        skillMentionAgents: Record<string, string[]>;
        onSkillMentionChange: (skillId: string, agentIds: string[]) => void;
      };
    },
    ref: Ref<unknown>,
  ) {
    const valueRef = useRef(defaultValue ?? "");
    // Mirrors the real editor's skill-mention nodes: getSkillMentionIds answers
    // the skill ids whose chips are currently in the document.
    const skillMentionIdsRef = useRef<string[]>([]);
    const inFlightRef = useRef(0);

    useEffect(() => {
      onReady?.();
      onUploadingChange?.(inFlightRef.current > 0);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useImperativeHandle(ref, () => ({
      getMarkdown: () => valueRef.current,
      getSkillMentionIds: () => skillMentionIdsRef.current,
      clearContent: () => {
        valueRef.current = "";
        skillMentionIdsRef.current = [];
      },
      focus: () => {},
      focusAtCoords: () => {},
      blur: () => {},
      uploadFile: async (file: File) => {
        inFlightRef.current += 1;
        if (inFlightRef.current === 1) onUploadingChange?.(true);
        try {
          const result = await onUploadFile?.(file, `mock-upload-${++mockUploadIdSeq}`);
          if (!result) return;
          valueRef.current = `${valueRef.current}\n${result.url}`.trim();
          onUpdate?.(valueRef.current);
        } finally {
          inFlightRef.current -= 1;
          if (inFlightRef.current === 0) onUploadingChange?.(false);
        }
      },
      hasActiveUploads: () => inFlightRef.current > 0,
      insertUploadPlaceholder: () => true,
      settleUploadPlaceholder: () => false,
    }));

    return (
      <div>
        <textarea
          data-testid="editor"
          defaultValue={defaultValue}
          onChange={(e) => {
            valueRef.current = e.target.value;
            onUpdate?.(e.target.value);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onSubmit?.();
          }}
        />
        {skillMentionContext && (
          <div data-testid="skill-mention-panel">
            <button
              type="button"
              data-testid="skill-mention-add"
              onClick={() => {
                skillMentionIdsRef.current = ["skill-1"];
                onUpdate?.(valueRef.current);
              }}
            >
              Add skill mention
            </button>
            <button
              type="button"
              data-testid="skill-mention-toggle-agent"
              onClick={() =>
                skillMentionContext.onSkillMentionChange(
                  "skill-1",
                  (skillMentionContext.skillMentionAgents["skill-1"] ?? []).includes("agent-1")
                    ? []
                    : ["agent-1"],
                )
              }
            >
              Toggle skill agent
            </button>
          </div>
        )}
      </div>
    );
  }),
}));

import { CommentCard } from "./comment-card";

const entry: TimelineEntry = {
  id: "comment-1",
  issue_id: "issue-1",
  parent_id: null,
  actor_type: "member",
  actor_id: "user-1",
  content: "Original body",
  type: "comment",
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
  attachments: [],
  reactions: [],
} as unknown as TimelineEntry;

function renderCard(onReply = vi.fn().mockResolvedValue(true)) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = renderWithI18n(
    <QueryClientProvider client={qc}>
      <CommentCard
        issueId="issue-1"
        entry={entry}
        replies={[]}
        currentUserId="user-1"
        onReply={onReply}
        onEdit={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn()}
        onToggleReaction={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return { ...view, onReply };
}

/** ReplyInput is readonly-first: activate the shell the way a user does, then
 *  type into the mounted editor. */
async function startReply(text: string) {
  fireEvent.click(screen.getByTestId("reply-composer-shell"));
  const editor = await screen.findByTestId("editor");
  fireEvent.change(editor, { target: { value: text } });
  return editor;
}

beforeEach(() => {
  uploadWithToast.mockReset();
  apiUploadFile.mockReset();
  apiListAgents.mockReset().mockResolvedValue([]);
  useCommentDraftStore.setState({ drafts: {} });
});

// KTD6 — the reply composer's skill designations must survive the CommentCard
// boundary. ReplyInput already forwards them as the 4th onSubmit argument and
// useIssueTimeline.submitReply already accepts them as the 5th parameter; the
// card's onSubmit wrapper used to be the silent drop point.
describe("CommentCard reply — skill designation forwarding", () => {
  it("forwards the reply composer's skill designations to onReply as the 5th argument", async () => {
    const onReply = vi.fn().mockResolvedValue(true);
    renderCard(onReply);

    await startReply("hello");
    fireEvent.click(screen.getByTestId("skill-mention-add"));
    fireEvent.click(screen.getByTestId("skill-mention-toggle-agent"));

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onReply).toHaveBeenCalledTimes(1));

    const [parentId, content, attachmentIds, suppressAgentIds, skillMentionAgents] =
      onReply.mock.calls[0]!;
    expect(parentId).toBe("comment-1");
    expect(content).toBe("hello");
    expect(attachmentIds).toBeUndefined();
    expect(suppressAgentIds).toBeUndefined();
    expect(skillMentionAgents).toEqual({ "skill-1": ["agent-1"] });
  });

  it("passes undefined (never an empty object) as the 5th argument for a reply without skill designations", async () => {
    const onReply = vi.fn().mockResolvedValue(true);
    renderCard(onReply);

    await startReply("hi");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onReply).toHaveBeenCalledTimes(1));

    // Positional pin: the 5th argument slot is forwarded even when empty —
    // assert on the raw call so a dropped (vs undefined) argument cannot pass
    // through an equals-style comparison that ignores trailing undefined.
    const call = onReply.mock.calls[0]!;
    expect(call.length).toBe(5);
    expect(call[0]).toBe("comment-1");
    expect(call[1]).toBe("hi");
    expect(call[2]).toBeUndefined();
    expect(call[3]).toBeUndefined();
    expect(call[4]).toBeUndefined();
  });
});
